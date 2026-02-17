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

export const Shot18: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 7.73s total
	// Segments: 0-7s (Tension), 7-14s (Loosening) scaled
	const splitFrame = Math.round((7 / 14) * durationInFrames);

	// Tension Animation (0 - splitFrame)
	// Shaking effect to simulate pulling
	const tensionShake = frame < splitFrame 
		? Math.sin(frame * 0.8) * 5 
		: 0;

	// Loosening Animation (splitFrame - end)
	// Move image slightly to one side and reduce tension shake
	const looseningOffset = interpolate(
		frame,
		[splitFrame, durationInFrames],
		[0, 30],
		{extrapolateLeft: 'clamp', easing: Easing.out(Easing.quad)}
	);

	// Text Overlay 'три месяца на примирение'
	const textOpacity = interpolate(
		frame,
		[durationInFrames - 30, durationInFrames - 10],
		[0, 1],
		{extrapolateLeft: 'clamp'}
	);

	return (
		<AbsoluteFill style={{backgroundColor: '#222'}}>
			{/* Main Image with Tension/Loosening effects */}
			<AbsoluteFill
				style={{
					transform: `translateX(${tensionShake + looseningOffset}px)`,
				}}
			>
				<Img
					src={staticFile('tug_of_war_divorce.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Dramatic Contrast Overlay */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle, transparent 30%, rgba(0,0,0,0.4) 100%)',
					pointerEvents: 'none',
				}}
			/>

			{/* Overlay Text */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-white/90 px-10 py-5 rounded-sm shadow-2xl border-l-8 border-green-600"
					style={{opacity: textOpacity}}
				>
					<h2 
						className="text-green-900 text-5xl font-bold uppercase tracking-tighter"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						три месяца на примирение
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot18_voice.mp3')} />
		</AbsoluteFill>
	);
};
