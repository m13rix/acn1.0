import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	random,
} from 'remotion';
import React from 'react';

export const Shot6: React.FC = () => {
	const frame = useCurrentFrame();
	const {fps, durationInFrames} = useVideoConfig();

	// Timeline mapping
	// Original: 0-12s. Target: 4.92s.
	// 0-4s (Unroll) -> 0 - 1.64s
	const unrollDuration = Math.round(1.64 * fps);
	
	// 4-12s (Text) -> 1.64s - 4.92s
	const textStart = unrollDuration;
	
	// Scroll Unroll Animation (Mask Reveal)
	const scrollReveal = interpolate(frame, [0, unrollDuration], [0, 100], {
		extrapolateRight: 'clamp',
	});

	// Hand Shadow Animation (Moving across)
	const shadowX = interpolate(frame, [0, unrollDuration], [-100, 200], {
		extrapolateRight: 'clamp',
	});

	// Candlelight Flicker Effect
	// Use random noise based on frame for flickering opacity
	const flickerBase = 0.15; // Base opacity
	const flickerVar = random(frame) * 0.1; // Variance
	const flickerOpacity = flickerBase + flickerVar;

	// Text Items
	const items = [
		'• Уже женат',
		'• Близкое родство',
		'• Усыновление',
		'• Недееспособность',
	];

	// Calculate start times for each item to appear sequentially between textStart and end of video
	const timePerItem = (durationInFrames - textStart - 10) / items.length; // -10 frames buffer

	return (
		<AbsoluteFill style={{backgroundColor: '#1a1a1a'}}>
			{/* Scroll Image with Reveal Mask */}
			<AbsoluteFill
				style={{
					clipPath: `inset(0 0 ${100 - scrollReveal}% 0)`, // Unroll from top
				}}
			>
				<Img
					src={staticFile('black_list_scroll.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Hand Shadow Overlay during unroll */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle, rgba(0,0,0,0.8) 0%, transparent 70%)',
					transform: `translateX(${shadowX}%) skewX(-20deg)`,
					width: '100%',
					opacity: frame < unrollDuration ? 0.6 : 0,
				}}
			/>

			{/* Typewriter Text Items */}
			<AbsoluteFill
				style={{
					justifyContent: 'center',
					alignItems: 'center',
					paddingTop: 100, // Adjust based on scroll visual position
				}}
			>
				<div className="flex flex-col space-y-4">
					{items.map((item, index) => {
						const itemStart = textStart + index * timePerItem;
						const chars = item.split('');
						
						return (
							<div key={index} className="flex flex-row">
								{chars.map((char, charIndex) => {
									// Typewriter effect for each character
									// Very fast typing
									const charStart = itemStart + charIndex * 1.5; 
									const charOpacity = interpolate(frame, [charStart, charStart + 1], [0, 1], {
										extrapolateRight: 'clamp',
									});
									
									return (
										<span
											key={charIndex}
											style={{
												opacity: charOpacity,
												fontFamily: 'Inter, sans-serif', // Or a handwritten font if available
												fontWeight: 'bold',
												color: '#2d1b0e', // Ink color (dark brown/black)
												fontSize: 50,
											}}
										>
											{char}
										</span>
									);
								})}
							</div>
						);
					})}
				</div>
			</AbsoluteFill>

			{/* Candlelight Overlay */}
			<AbsoluteFill
				style={{
					backgroundColor: '#ffaa00', // Orange/Gold
					opacity: flickerOpacity,
					mixBlendMode: 'overlay',
					pointerEvents: 'none',
				}}
			/>
			{/* Vignette for atmosphere */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle, transparent 40%, black 100%)',
					pointerEvents: 'none',
					opacity: 0.6,
				}}
			/>

			<Audio src={staticFile('shot6_voice.mp3')} />
		</AbsoluteFill>
	);
};
