import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot39: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Slow deliberate camera push (0-8s scaled to 6.53s)
	const zoom = interpolate(frame, [0, durationInFrames], [1, 1.15], {
		easing: Easing.out(Easing.quad),
	});

	// Deliberate movement simulation (Subtle pan)
	const panX = interpolate(frame, [0, durationInFrames], [0, -20]);

	// Intellectual Spotlight
	const spotlightOpacity = interpolate(frame, [0, 30], [0, 0.4], {extrapolateRight: 'clamp'});

	// Text Overlay 'Знание = Сила'
	const textOpacity = interpolate(frame, [durationInFrames * 0.4, durationInFrames * 0.6], [0, 1], {
		extrapolateLeft: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: '#0a0a0a'}}>
			{/* Main Image */}
			<AbsoluteFill
				style={{
					transform: `scale(${zoom}) translateX(${panX}px)`,
				}}
			>
				<Img
					src={staticFile('chess_rings.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'contrast(1.2) brightness(0.8) grayscale(0.2)',
					}}
				/>
			</AbsoluteFill>

			{/* Intellectual Spotlight Overlay */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle at 40% 40%, rgba(255, 255, 255, 0.1) 0%, transparent 50%)',
					opacity: spotlightOpacity,
					pointerEvents: 'none',
				}}
			/>
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle at 50% 50%, transparent 30%, rgba(0,0,0,0.7) 100%)',
					pointerEvents: 'none',
				}}
			/>

			{/* Overlay Text */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-white/10 backdrop-blur-md px-12 py-6 rounded border border-white/30 shadow-2xl"
					style={{
						opacity: textOpacity,
						transform: `translateY(${interpolate(textOpacity, [0, 1], [40, 0])}px)`
					}}
				>
					<h2 
						className="text-white text-7xl font-light tracking-widest uppercase italic"
						style={{fontFamily: 'Inter, sans-serif', textShadow: '0 0 30px rgba(255,255,255,0.3)'}}
					>
						Знание = Сила
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot39_voice.mp3')} />
		</AbsoluteFill>
	);
};
