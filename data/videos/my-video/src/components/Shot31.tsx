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

export const Shot31: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 7.49s total
	// Original: 0-7s (Top crumple), 7-14s (Bottom bubble) -> 50/50 split approx
	const splitFrame = Math.round(durationInFrames / 2);

	// Top Animation: Document Crumbling (0 - splitFrame)
	// Simulate crumbling with scale down, rotation, and distortion (if possible, otherwise just shake/fade)
	// We'll use a "crumble" like scale down and shake
	const crumbleProgress = interpolate(
		frame,
		[0, splitFrame],
		[0, 1],
		{extrapolateRight: 'clamp', easing: Easing.in(Easing.poly(3))}
	);
	
	const topScale = interpolate(crumbleProgress, [0, 1], [1, 0]);
	const topRotate = interpolate(crumbleProgress, [0, 1], [0, 360]);
	const topOpacity = interpolate(crumbleProgress, [0.8, 1], [1, 0]);

	// Bottom Animation: Child in Bubble (splitFrame - end)
	// Bubble pop in and float
	const bottomProgress = interpolate(
		frame,
		[splitFrame, durationInFrames],
		[0, 1],
		{extrapolateLeft: 'clamp'}
	);

	const bubbleScale = interpolate(bottomProgress, [0, 0.2, 1], [0, 1.1, 1]);
	const bubbleFloat = Math.sin((frame - splitFrame) * 0.1) * 10;

	// Text Overlay
	const text1Opacity = interpolate(frame, [splitFrame, splitFrame + 10], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
	const text2Opacity = interpolate(frame, [splitFrame + 10, splitFrame + 20], [0, 1], {extrapolateLeft: 'clamp'});

	return (
		<AbsoluteFill style={{backgroundColor: '#e0e0e0'}}>
			<div className="flex flex-col w-full h-full">
				{/* Top Half: Document Crumble */}
				<div className="h-1/2 w-full relative overflow-hidden bg-gray-300 flex justify-center items-center">
					<div
						style={{
							width: '100%',
							height: '100%',
							transform: `scale(${topScale}) rotate(${topRotate}deg)`,
							opacity: topOpacity,
						}}
					>
						<Img
							src={staticFile('document_crumble_top.png')}
							style={{
								width: '100%',
								height: '100%',
								objectFit: 'cover',
							}}
						/>
					</div>
					{/* Debris particles could go here */}
				</div>

				{/* Bottom Half: Child Protection */}
				<div className="h-1/2 w-full relative overflow-hidden bg-blue-50 flex justify-center items-center border-t-4 border-blue-200">
					<div
						style={{
							width: '80%',
							height: '80%',
							transform: `scale(${bubbleScale}) translateY(${bubbleFloat}px)`,
						}}
					>
						<Img
							src={staticFile('child_bubble_protection.png')}
							style={{
								width: '100%',
								height: '100%',
								objectFit: 'contain',
							}}
						/>
						{/* Bubble Shine Overlay */}
						<div 
							className="absolute top-0 left-0 w-full h-full rounded-full"
							style={{
								background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.4) 0%, transparent 60%)',
								boxShadow: 'inset 0 0 20px rgba(255,255,255,0.5)',
							}}
						/>
					</div>
				</div>
			</div>

			{/* Overlay Texts */}
			<AbsoluteFill className="justify-center items-center pointer-events-none">
				<div className="flex flex-col items-center space-y-4">
					<div 
						className="bg-blue-600/90 px-6 py-2 rounded-full shadow-lg"
						style={{opacity: text1Opacity}}
					>
						<h2 className="text-white text-3xl font-bold uppercase">Дети защищены всегда</h2>
					</div>
					<div 
						className="bg-white/90 px-6 py-2 rounded-full shadow-lg border-2 border-blue-600"
						style={{opacity: text2Opacity}}
					>
						<h2 className="text-blue-800 text-2xl font-bold uppercase">триста дней</h2>
					</div>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot31_voice.mp3')} />
		</AbsoluteFill>
	);
};
